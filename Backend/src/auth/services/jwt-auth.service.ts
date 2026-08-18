import { Injectable, Logger } from '@nestjs/common';
import { JwtService as NestJwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../entities/refresh-token.entity';
import { User } from '../entities/user.entity';
import { randomUUID as uuidv4 } from 'crypto';
import { AuditService } from '../../audit/audit.service';
import { SecretsMaskingService } from '../../config/secrets-masking.service';
import {
  TokenExpiredError,
  TokenInvalidError,
  UnauthorizedError,
} from '../../common/exceptions/api-error.exception';

export interface JwtPayload {
  sub: string; // user id
  walletId?: string;
  iat?: number;
  exp?: number;
}

export interface RefreshResult {
  accessToken: string;
  newRefreshToken: string;
  familyId: string;
  /** IDs of all tokens revoked as part of this operation (family abuse). */
  revokedTokenIds?: string[];
}

@Injectable()
export class JwtAuthService {
  private readonly logger = new Logger(JwtAuthService.name);
  private readonly REFRESH_EXPIRATION_DAYS = 7;

  constructor(
    private readonly jwtService: NestJwtService,
    private readonly configService: ConfigService,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    private readonly maskingService: SecretsMaskingService,
  ) {}

  generateAccessToken(userId: string, walletId?: string): string {
    const payload: JwtPayload = {
      sub: userId,
      walletId,
    };

    return this.jwtService.sign(payload, {
      expiresIn: this.configService.get('JWT_ACCESS_EXPIRATION', '15m'),
    });
  }

  async generateRefreshToken(
    userId: string,
    familyId?: string,
  ): Promise<{ token: string; id: string; expiresAt: Date; familyId: string }> {
    const token = uuidv4();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.REFRESH_EXPIRATION_DAYS);

    // The first token of a session seeds the family; subsequent rotations reuse it.
    const resolvedFamilyId = familyId ?? uuidv4();

    const refreshToken = this.refreshTokenRepository.create({
      token,
      userId,
      expiresAt,
      revoked: false,
      familyId: resolvedFamilyId,
    });

    const saved = await this.refreshTokenRepository.save(refreshToken);

    // Refresh token creation is routine — no audit event to avoid log noise.
    // Sensitive operations (rotation, revocation, abuse) are audited.

    return {
      token: saved.token,
      id: saved.id,
      expiresAt: saved.expiresAt,
      familyId: resolvedFamilyId,
    };
  }

  validateAccessToken(token: string): JwtPayload {
    try {
      const payload = this.jwtService.verify<JwtPayload>(token);
      return payload;
    } catch (error) {
      // Mask the raw exception message — it may contain parts of the token
      // or the signing secret if the library surfaces them.
      const safeMessage = this.maskingService.mask(
        (error as Error).message ?? 'unknown error',
      );
      this.logger.warn(`Access token validation failed: ${safeMessage}`);
      throw new TokenInvalidError('Invalid or expired access token');
    }
  }

  async refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
    const tokenRecord = await this.refreshTokenRepository.findOne({
      where: { token: refreshToken },
      relations: { user: true },
    });

    // Unknown token: treat as a generic invalid-credential failure and emit a
    // minimal audit signal without leaking whether the token existed.
    if (!tokenRecord) {
      await this.auditService.logAction(
        'REFRESH_TOKEN_REUSE_DETECTED',
        'unknown',
        undefined,
        { reason: 'unknown_token' },
      );
      throw new TokenInvalidError('Invalid or expired refresh token');
    }

    // Reuse detection: a token being presented *after* it was already rotated
    // is a classic replay signal. Revoke the entire family and fail hard.
    if (tokenRecord.revoked) {
      const revokedIds = await this.revokeFamily(tokenRecord, 'reuse_detected');
      await this.auditService.logAction(
        'TOKEN_FAMILY_ABUSE',
        tokenRecord.userId,
        tokenRecord.id,
        {
          familyId: tokenRecord.familyId,
          reason: 'reuse_detected',
          revokedTokenIds: revokedIds,
        },
      );
      throw new TokenInvalidError(
        'Refresh token reused after rotation. All sessions revoked.',
      );
    }

    if (new Date() > tokenRecord.expiresAt) {
      await this.revokeRefreshToken(tokenRecord.id, 'expired');
      throw new TokenExpiredError('Refresh token expired');
    }

    if (!tokenRecord.user?.isActive) {
      await this.revokeRefreshToken(tokenRecord.id, 'inactive_user');
      throw new UnauthorizedError('User account is inactive');
    }

    const familyId = tokenRecord.familyId ?? uuidv4();
    const now = new Date();

    // Generate replacement tokens first so we can atomically link the chain
    // inside the same transaction that revokes the old token.
    const accessToken = this.generateAccessToken(tokenRecord.userId);
    const newRefreshTokenData = await this.generateRefreshToken(
      tokenRecord.userId,
      familyId,
    );

    // Rotate: atomically revoke the used token, record when it was replaced,
    // and link it to the fresh successor — all in one transaction so a crash
    // mid-rotation never leaves a half-linked chain.
    await this.dataSource.transaction(async (manager) => {
      const rtRepo = manager.getRepository(RefreshToken);
      await rtRepo.update(
        { id: tokenRecord.id },
        {
          revoked: true,
          revokedAt: now,
          replacedAt: now,
          replacedByToken: newRefreshTokenData.token,
        },
      );
    });

    await this.auditService.logAction(
      'ACCESS_TOKEN_REFRESHED',
      tokenRecord.userId,
      tokenRecord.id,
      { familyId, newTokenId: newRefreshTokenData.id },
    );

    return {
      accessToken,
      newRefreshToken: newRefreshTokenData.token,
      familyId,
    };
  }

  /**
   * Revoke every still-valid token in a family. Used on logout, abuse
   * detection, and expiry so a single leaked token cannot be replayed into a
   * fresh session elsewhere.
   *
   * @returns IDs of all tokens that were revoked (for audit metadata).
   */
  private async revokeFamily(
    tokenRecord: RefreshToken,
    reason: string,
  ): Promise<string[]> {
    const familyId = tokenRecord.familyId;
    if (!familyId) {
      await this.revokeRefreshToken(tokenRecord.id, reason);
      return [tokenRecord.id];
    }

    const siblings = await this.refreshTokenRepository.find({
      where: { familyId, revoked: false },
    });

    const now = new Date();
    await this.refreshTokenRepository.update(
      { familyId, revoked: false },
      { revoked: true, revokedAt: now, revokedReason: reason },
    );

    const revokedIds = siblings.map((s) => s.id);
    for (const sibling of siblings) {
      await this.auditService.logAction(
        'REFRESH_TOKEN_REVOKED',
        sibling.userId,
        sibling.id,
        { reason, familyId, scope: 'family' },
      );
    }

    return revokedIds;
  }

  async revokeRefreshToken(tokenId: string, reason = 'logout'): Promise<void> {
    const token = await this.refreshTokenRepository.findOne({
      where: { id: tokenId },
    });
    if (!token) {
      return;
    }

    await this.refreshTokenRepository.update(
      { id: tokenId },
      {
        revoked: true,
        revokedAt: new Date(),
        revokedReason: reason,
      },
    );

    await this.auditService.logAction(
      'REFRESH_TOKEN_REVOKED',
      token.userId,
      tokenId,
      { reason },
    );
  }

  async revokeAllUserRefreshTokens(
    userId: string,
    reason = 'logout',
  ): Promise<void> {
    const active = await this.refreshTokenRepository.find({
      where: { userId, revoked: false },
    });

    const now = new Date();
    await this.refreshTokenRepository.update(
      { userId, revoked: false },
      {
        revoked: true,
        revokedAt: now,
        revokedReason: reason,
      },
    );

    for (const token of active) {
      await this.auditService.logAction(
        'REFRESH_TOKEN_REVOKED',
        token.userId,
        token.id,
        { reason, scope: 'user' },
      );
    }
  }

  async getUserFromToken(token: string): Promise<User> {
    // validateAccessToken masks/logs internally and throws a structured error.
    const payload = this.validateAccessToken(token);

    const user = await this.userRepository.findOne({
      where: { id: payload.sub },
    });

    if (!user) {
      throw new TokenInvalidError('User not found');
    }

    if (!user.isActive) {
      throw new UnauthorizedError('User account is inactive');
    }

    return user;
  }
}

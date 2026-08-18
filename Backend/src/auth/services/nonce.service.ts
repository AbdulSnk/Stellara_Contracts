import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, LessThan, Repository } from 'typeorm';
import { LoginNonce } from '../entities/login-nonce.entity';
import { randomUUID as uuidv4 } from 'crypto';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InvalidNonceError } from '../../common/exceptions/api-error.exception';

@Injectable()
export class NonceService {
  private readonly NONCE_EXPIRATION_MINUTES = 5;

  constructor(
    @InjectRepository(LoginNonce)
    private readonly nonceRepository: Repository<LoginNonce>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async generateNonce(
    publicKey: string,
  ): Promise<{ nonce: string; expiresAt: Date; message: string }> {
    const nonce = uuidv4();
    const expiresAt = new Date();
    expiresAt.setMinutes(
      expiresAt.getMinutes() + this.NONCE_EXPIRATION_MINUTES,
    );

    const loginNonce = this.nonceRepository.create({
      nonce,
      publicKey,
      expiresAt,
      used: false,
    });

    await this.nonceRepository.save(loginNonce);

    const message = `Sign this message to authenticate with Stellara: ${nonce}`;

    return {
      nonce,
      expiresAt,
      message,
    };
  }

  /**
   * Atomically verify a nonce and consume it in a single transaction.
   *
   * Returning the row via `update ... returning` means a second concurrent
   * login with the same nonce fails the `used = false` predicate instead of
   * silently succeeding, closing the replay window. Any validation failure
   * (not found / already used / expired) throws before the nonce is touched,
   * so a failed signature check never leaves a consumed-but-unauthenticated
   * nonce behind.
   */
  async validateNonce(nonce: string, publicKey: string): Promise<LoginNonce> {
    if (!nonce || !publicKey) {
      throw new InvalidNonceError('Nonce and public key are required');
    }

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(LoginNonce);

      const loginNonce = await repo.findOne({
        where: { nonce, publicKey },
      });

      if (!loginNonce) {
        throw new InvalidNonceError('Invalid nonce');
      }

      if (loginNonce.used) {
        throw new InvalidNonceError('Nonce already used');
      }

      if (new Date() > loginNonce.expiresAt) {
        throw new InvalidNonceError('Nonce expired');
      }

      const consumedAt = new Date();
      const updateResult = await repo
        .createQueryBuilder()
        .update(LoginNonce)
        .set({ used: true, consumedAt })
        .where('nonce = :nonce AND publicKey = :publicKey AND used = false', {
          nonce,
          publicKey,
        })
        .returning('*')
        .execute();

      const consumed = (updateResult.raw as unknown[] | undefined)?.[0] as
        | LoginNonce
        | undefined;
      if (!consumed) {
        throw new InvalidNonceError('Nonce already used');
      }

      return repo.create(consumed);
    });
  }

  /**
   * @deprecated Prefer `validateNonce`, which consumes the nonce atomically.
   * Retained for callers that need to mark a nonce used out-of-band.
   */
  async markNonceUsed(nonce: string): Promise<void> {
    await this.nonceRepository.update({ nonce }, { used: true });
  }

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredNonces(): Promise<void> {
    const now = new Date();
    await this.nonceRepository.delete({
      expiresAt: LessThan(now),
    });
  }
}

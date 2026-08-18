import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';

@Entity('refresh_tokens')
@Index(['userId', 'revoked'])
@Index(['familyId'])
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  token: string;

  @ManyToOne(() => User, (user) => user.refreshTokens, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column()
  userId: string;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @Column({ default: false })
  revoked: boolean;

  @Column({ type: 'timestamp', nullable: true })
  revokedAt?: Date;

  /**
   * Why the token was revoked (e.g. 'logout', 'expired', 'reuse_detected',
   * 'family_abuse'). Stored for audit traceability.
   */
  @Column({ type: 'varchar', nullable: true })
  revokedReason?: string | null;

  @Column({ type: 'timestamp', nullable: true })
  replacedAt?: Date;

  /**
   * Tokens issued from a single login session (or chained refreshes) share a
   * family. When any token in a family is reused after being rotated, the
   * whole family is revoked to stop replay attacks.
   */
  @Column({ type: 'varchar', nullable: true })
  familyId?: string | null;

  @Column({ type: 'varchar', nullable: true })
  replacedByToken?: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;
}

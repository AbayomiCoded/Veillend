import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenCleanupService } from './token-cleanup.service';
import { WalletModule } from '../wallet/wallet.module';
import { JwtStrategy } from './jwt.strategy';
import { AppConfigService } from '../config/app-config.service';
import { ConfigModule } from '../config/config.module';

@Module({
  imports: [
    ConfigModule,
    WalletModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [AppConfigService],
      useFactory: (configService: AppConfigService) => ({
        secret: configService.auth.jwtSecret,
        signOptions: {
          expiresIn: configService.auth.jwtExpiresIn as
            | `${number}h`
            | `${number}m`
            | `${number}s`
            | `${number}d`
            | `${number}w`
            | `${number}y`
            | number,
          issuer: configService.auth.jwtIssuer,
          audience: configService.auth.jwtAudience,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, TokenCleanupService],
  exports: [AuthService, JwtStrategy],
})
export class AuthModule {}

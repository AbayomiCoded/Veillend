import { NestFactory } from '@nestjs/core';
import {
  BadRequestException,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { AppModule } from './app.module';
import { AppLoggerService } from './common/logging/app-logger.service';
import { AppConfigService } from './config/app-config.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  
  app.useLogger(app.get(AppLoggerService));
  
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    // Default ValidationPipe sets exception.message to the generic
    // "Bad Request Exception", hiding the actual constraint message from
    // the ApiResponseDto.fail envelope. Surface it explicitly instead.
    exceptionFactory: (errors: ValidationError[]) => {
      const message = errors
        .flatMap((error) => Object.values(error.constraints ?? {}))
        .join('; ');
      return new BadRequestException(message || 'Validation failed');
    },
  }));
  
  const config = app.get(AppConfigService);
  await app.listen(config.port);
}
void bootstrap();

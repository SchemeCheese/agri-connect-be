import { ValidationPipe, ValidationError } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';

// ValidationPipe cho WebSocket: chuyển BadRequestException → WsException
// để FE nhận lỗi qua kênh socket 'exception' với message rõ ràng (không phải HTTP 400).
export const wsValidationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  exceptionFactory: (errors: ValidationError[]) => {
    const msg = errors
      .map((e) => Object.values(e.constraints ?? {}).join(', '))
      .filter(Boolean)
      .join('; ');
    return new WsException(msg || 'Payload không hợp lệ.');
  },
});

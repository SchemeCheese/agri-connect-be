import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole, ROLES_KEY } from '../roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles) return true;

    const { user } = context.switchToHttp().getRequest();

    // ─── Active-Role enforcement ──────────────────────────────────────────────
    // Guard CHỈ tin `activeRole` đã ký trong JWT, KHÔNG tin các flag is_seller/
    // is_buyer trong DB. Nhờ vậy một user sở hữu cả 2 vai trò nhưng đang ở
    // workspace BUYER sẽ bị 403 khi gọi route SELLER (và ngược lại) — đúng yêu cầu
    // tách workspace, và FE không thể "giả" quyền vì activeRole do BE phát ra.
    const activeRole = user?.activeRole as UserRole | null | undefined;

    if (!activeRole) {
      // Token cũ (legacy, chưa có activeRole) → buộc đăng nhập lại để lấy token mới.
      throw new ForbiddenException('Phiên không hợp lệ. Vui lòng đăng nhập lại.');
    }

    // ADMIN là superuser — đi qua mọi route có @Roles.
    if (activeRole === UserRole.ADMIN) return true;

    if (!requiredRoles.includes(activeRole)) {
      throw new ForbiddenException(
        `Hành động này yêu cầu vai trò ${requiredRoles.join('/')}, nhưng bạn đang ở chế độ ${activeRole}.`,
      );
    }

    return true;
  }
}

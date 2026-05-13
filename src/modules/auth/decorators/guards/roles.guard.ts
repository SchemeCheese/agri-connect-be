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

    const hasRole = requiredRoles.some((role) => {
      if (role === UserRole.BUYER)  return user?.is_buyer;
      if (role === UserRole.SELLER) return user?.is_seller;
      if (role === UserRole.ADMIN)  return user?.is_admin;
      return false;
    });

    if (!hasRole) {
      throw new ForbiddenException('Bạn không có quyền thực hiện hành động này!');
    }

    return true;
  }
}

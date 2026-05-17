import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { UpdateProfileDto } from './dtos/update-profile.dto';
import { TargetType } from '@prisma/client';

/**
 * Accept the host families Google ships maps under. Includes the mobile
 * short-link host (maps.app.goo.gl) and the desktop /maps path.
 */
function isGoogleMapsUrl(raw: string): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (host === 'maps.app.goo.gl' || host === 'goo.gl') return true;
    if (host === 'maps.google.com') return true;
    if (/(^|\.)google\.[a-z.]+$/.test(host) && u.pathname.startsWith('/maps')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Best-effort lat/lng extraction from a desktop Google Maps URL. We do NOT
 * follow redirects for short links (maps.app.goo.gl) — those just store the
 * URL verbatim. Patterns covered:
 *   /@lat,lng           e.g. .../maps/@21.0285,105.8542,17z
 *   ?q=lat,lng          e.g. .../maps?q=21.0285,105.8542
 *   !3dlat!4dlng        e.g. .../data=!3m1!1e1!3d21.0285!4d105.8542
 */
function extractLatLngFromMapsUrl(url: string): { lat: number; lng: number } | null {
  if (!url) return null;
  const at = url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (at) return { lat: Number(at[1]), lng: Number(at[2]) };
  const q = url.match(/[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (q) return { lat: Number(q[1]), lng: Number(q[2]) };
  const d = url.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (d) return { lat: Number(d[1]), lng: Number(d[2]) };
  return null;
}

/**
 * Choose the URL a buyer should be sent to when they click the shop location.
 *   1. shop_google_maps_url  — the URL the seller explicitly pasted (preserves zoom, place name, etc.)
 *   2. lat,lng pair          — open the search API with coordinates
 *   3. plain address text    — open the search API with the address as query
 * Returns null if none of those are usable.
 */
export function buildMapsOpenUrl(p: {
  shop_google_maps_url?: string | null;
  shop_latitude?: number | null;
  shop_longitude?: number | null;
  address?: string | null;
}): string | null {
  if (p.shop_google_maps_url) return p.shop_google_maps_url;
  if (p.shop_latitude != null && p.shop_longitude != null) {
    return `https://www.google.com/maps/search/?api=1&query=${p.shop_latitude},${p.shop_longitude}`;
  }
  if (p.address && p.address.trim()) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address.trim())}`;
  }
  return null;
}

@Injectable()
export class ProfileService {
  constructor(private readonly db: DatabaseService) {}

  // ─── GET /profile/me ─────────────────────────────────────────────────────
  async getMyProfile(userId: string) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        full_name: true,
        phone_number: true,
        is_buyer: true,
        is_seller: true,
        is_admin: true,
        verified_email: true,
        created_at: true,
        profile: true,
      },
    });

    if (!user) throw new NotFoundException('Người dùng không tồn tại.');

    const avatarAttachment = await this.db.attachment.findFirst({
      where: { target_id: userId, target_type: TargetType.AVATAR },
      orderBy: { created_at: 'desc' },
      select: { id: true, url: true },
    });

    const profile = user.profile;
    const lat = profile?.shop_latitude != null ? Number(profile.shop_latitude) : null;
    const lng = profile?.shop_longitude != null ? Number(profile.shop_longitude) : null;

    return {
      ...user,
      avatar: avatarAttachment?.url ?? null,
      profile: profile && {
        ...profile,
        shop_latitude: lat,
        shop_longitude: lng,
        shop_maps_open_url: buildMapsOpenUrl({
          shop_google_maps_url: profile.shop_google_maps_url,
          shop_latitude: lat,
          shop_longitude: lng,
          address: profile.address,
        }),
      },
    };
  }

  // ─── PATCH /profile/me — Cập nhật thông tin (không kèm ảnh) ─────────────
  async updateProfile(userId: string, dto: UpdateProfileDto) {
    // 1. User-level fields (full_name, phone_number)
    const userUpdateData: Record<string, any> = {};
    if (dto.full_name !== undefined)    userUpdateData.full_name = dto.full_name;
    if (dto.phone_number !== undefined) userUpdateData.phone_number = dto.phone_number;
    if (Object.keys(userUpdateData).length > 0) {
      await this.db.user.update({ where: { id: userId }, data: userUpdateData });
    }

    // 2. Profile-level fields. Aliases (store_address, store_description) map onto canonical columns.
    const profileUpdate: Record<string, any> = {};
    if (dto.store_name !== undefined)        profileUpdate.store_name  = dto.store_name;
    if (dto.address !== undefined)           profileUpdate.address     = dto.address;
    if (dto.store_address !== undefined)     profileUpdate.address     = dto.store_address;
    if (dto.description !== undefined)       profileUpdate.description = dto.description;
    if (dto.store_description !== undefined) profileUpdate.description = dto.store_description;

    // 3. Shop location — validate URL, parse lat/lng if seller didn't supply them.
    if (dto.shop_location_name !== undefined) profileUpdate.shop_location_name = dto.shop_location_name;
    if (dto.place_id !== undefined)           profileUpdate.place_id = dto.place_id;

    if (dto.shop_google_maps_url !== undefined) {
      const url = dto.shop_google_maps_url?.trim() || '';
      if (url && !isGoogleMapsUrl(url)) {
        throw new BadRequestException(
          'URL Google Maps không hợp lệ. Hãy dán link có dạng https://www.google.com/maps/... hoặc https://maps.app.goo.gl/...',
        );
      }
      profileUpdate.shop_google_maps_url = url || null;

      // Auto-parse lat/lng from the URL when the seller didn't paste them explicitly
      if (url && dto.shop_latitude === undefined && dto.shop_longitude === undefined) {
        const parsed = extractLatLngFromMapsUrl(url);
        if (parsed) {
          profileUpdate.shop_latitude = parsed.lat;
          profileUpdate.shop_longitude = parsed.lng;
        }
      }
    }
    if (dto.shop_latitude !== undefined)  profileUpdate.shop_latitude  = dto.shop_latitude;
    if (dto.shop_longitude !== undefined) profileUpdate.shop_longitude = dto.shop_longitude;

    if (Object.keys(profileUpdate).length > 0) {
      await this.db.profile.upsert({
        where: { user_id: userId },
        update: profileUpdate,
        create: { user_id: userId, ...profileUpdate },
      });
    }

    return this.getMyProfile(userId);
  }

  // ─── PATCH /profile/me/avatar ─────────────────────────────────────────────
  async updateAvatar(userId: string, fileUrl: string) {
    await this.db.attachment.deleteMany({
      where: { target_id: userId, target_type: TargetType.AVATAR },
    });
    await this.db.attachment.create({
      data: {
        url: fileUrl,
        file_type: 'IMAGE',
        target_id: userId,
        target_type: TargetType.AVATAR,
      },
    });
    return { avatar: fileUrl };
  }

  // ─── POST /profile/me/banner ──────────────────────────────────────────────
  async updateCover(userId: string, fileUrl: string) {
    await this.db.profile.upsert({
      where: { user_id: userId },
      update: { cover_url: fileUrl },
      create: { user_id: userId, cover_url: fileUrl },
    });
    return { cover_url: fileUrl };
  }

  // ─── POST /profile/me/banners — append one image to banners1 (max 3) ─────
  async addBanner(userId: string, fileUrl: string) {
    const profile = await this.db.profile.findUnique({ where: { user_id: userId } });
    const current = profile?.banners1 ?? [];
    if (current.length >= 3) {
      throw new BadRequestException('Tối đa 3 banner — hãy xóa bớt trước khi thêm.');
    }
    const next = [...current, fileUrl];
    await this.db.profile.upsert({
      where: { user_id: userId },
      update: { banners1: next },
      create: { user_id: userId, banners1: next },
    });
    return { banners: next };
  }

  // ─── DELETE /profile/me/banners — remove one image from banners1 ─────────
  async removeBanner(userId: string, url: string) {
    const profile = await this.db.profile.findUnique({ where: { user_id: userId } });
    const current = profile?.banners1 ?? [];
    const next = current.filter((u) => u !== url);
    if (next.length === current.length) {
      throw new NotFoundException('Banner không tồn tại trong shop.');
    }
    await this.db.profile.update({
      where: { user_id: userId },
      data: { banners1: next },
    });
    return { banners: next };
  }
}

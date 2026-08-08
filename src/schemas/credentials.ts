import { z } from 'zod';

export const YandexOAuthPayload = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.coerce.date().optional(),
  clientLogin: z.string().optional(),
});

export const VkOAuthPayload = z.object({
  accessToken: z.string().min(1),
  adAccountId: z.string().min(1),
  expiresAt: z.coerce.date().optional(),
});

export const TikTokOAuthPayload = z.object({
  accessToken: z.string().min(1),
  advertiserId: z.string().min(1),
  refreshToken: z.string().optional(),
  expiresAt: z.coerce.date().optional(),
});

export type YandexOAuthPayloadType = z.infer<typeof YandexOAuthPayload>;
export type VkOAuthPayloadType = z.infer<typeof VkOAuthPayload>;
export type TikTokOAuthPayloadType = z.infer<typeof TikTokOAuthPayload>;

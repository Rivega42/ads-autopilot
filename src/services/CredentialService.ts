import type { Provider } from '@prisma/client';

import { CredentialRepository } from '../repos/CredentialRepository.js';
import {
  TikTokOAuthPayload as TikTokSchema,
  VkOAuthPayload as VkSchema,
  YandexOAuthPayload as YandexSchema,
} from '../schemas/credentials.js';
import type {
  TikTokOAuthPayloadType,
  VkOAuthPayloadType,
  YandexOAuthPayloadType,
} from '../schemas/credentials.js';

import { logAudit } from './auditLog.js';

export class CredentialNotFoundError extends Error {
  constructor(clientId: string, provider: string) {
    super(`No credential found for client ${clientId} provider ${provider}`);
    this.name = 'CredentialNotFoundError';
  }
}

export class CredentialService {
  private readonly repo: CredentialRepository;

  constructor(repo?: CredentialRepository) {
    this.repo = repo ?? new CredentialRepository();
  }

  async saveYandex(clientId: string, payload: YandexOAuthPayloadType): Promise<void> {
    const validated = YandexSchema.parse(payload);
    await this.repo.save(clientId, 'YANDEX_DIRECT', validated);
    await logAudit({ actor: clientId, action: 'credential.save', resource: `yandex:${clientId}` });
  }

  async saveVk(clientId: string, payload: VkOAuthPayloadType): Promise<void> {
    const validated = VkSchema.parse(payload);
    await this.repo.save(clientId, 'VK_ADS', validated);
    await logAudit({ actor: clientId, action: 'credential.save', resource: `vk:${clientId}` });
  }

  async saveTikTok(clientId: string, payload: TikTokOAuthPayloadType): Promise<void> {
    const validated = TikTokSchema.parse(payload);
    await this.repo.save(clientId, 'TIKTOK_ADS', validated);
    await logAudit({ actor: clientId, action: 'credential.save', resource: `tiktok:${clientId}` });
  }

  async getYandexToken(clientId: string): Promise<YandexOAuthPayloadType> {
    return this._get(clientId, 'YANDEX_DIRECT', YandexSchema);
  }

  async getVkToken(clientId: string): Promise<VkOAuthPayloadType> {
    return this._get(clientId, 'VK_ADS', VkSchema);
  }

  async getTikTokToken(clientId: string): Promise<TikTokOAuthPayloadType> {
    return this._get(clientId, 'TIKTOK_ADS', TikTokSchema);
  }

  private async _get<T>(
    clientId: string,
    provider: Provider,
    schema: { parse: (v: unknown) => T },
  ): Promise<T> {
    const raw = await this.repo.getPayload(clientId, provider);
    await logAudit({
      actor: clientId,
      action: 'credential.read',
      resource: `${provider.toLowerCase()}:${clientId}`,
    });
    if (!raw) throw new CredentialNotFoundError(clientId, provider);
    return schema.parse(raw);
  }

  async revoke(clientId: string, provider: Provider): Promise<void> {
    await this.repo.deactivate(clientId, provider);
    await logAudit({
      actor: clientId,
      action: 'credential.revoke',
      resource: `${provider.toLowerCase()}:${clientId}`,
    });
  }
}

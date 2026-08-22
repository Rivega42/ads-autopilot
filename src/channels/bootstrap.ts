import { registerAdapter, registeredChannels } from './registry.js';

import { registerCampaignApprovalExecutor } from '@/campaigns/index.js';
import { vkAdsAdapter } from '@/clients/vk-ads/adapter.js';
import { yandexDirectAdapter } from '@/clients/yandex-direct/index.js';
import { logger } from '@/logger.js';

let done = false;

/**
 * Наполняет реестр адаптеров. Без вызова getAdapter() бросает ADAPTER_MISSING,
 * то есть загрузка статистики и применение решений молча не работают.
 *
 * Держится отдельным модулем, а не в registry.ts, чтобы реестр не тянул за
 * собой все клиенты: тестам оптимизатора не нужны ни axios, ни очереди VK.
 *
 * Идемпотентна: каждая точка входа зовёт её у себя, не зная о других.
 */
export function bootstrapChannels(): void {
  if (done) return;
  done = true;

  registerAdapter(yandexDirectAdapter);
  registerAdapter(vkAdsAdapter);

  // Без этого апрув на создание кампании отклоняется как неподдерживаемый.
  registerCampaignApprovalExecutor();

  logger.info({ channels: registeredChannels() }, 'channel adapters registered');
}

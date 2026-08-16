/** Минимальный контракт транспорта: в бою — YandexDirectClient, в тестах и dry-run — запись вызовов. */
export interface Transport {
  request<TResult>(
    service: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<TResult>;
}

export interface RecordedCall {
  readonly service: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface DeployedCampaign {
  readonly name: string;
  readonly id: number;
  readonly groups: readonly { readonly name: string; readonly id: number }[];
}

export interface DeployResult {
  readonly campaigns: readonly DeployedCampaign[];
  readonly keywordCount: number;
  readonly adCount: number;
  readonly calls: readonly RecordedCall[];
}

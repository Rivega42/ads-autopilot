import { describe, expect, it, vi } from 'vitest';

import {
  FusionBrainProvider,
  sniffMimeType,
  type FetchLike,
  type FusionBrainDeps,
} from './fusionbrain.js';
import { ImageGenerationTimeoutError, ImageProviderNotConfiguredError } from './provider.js';

/**
 * Провайдер проверяется без сети и без ключей: `fetch` подменён, ключи переданы
 * прямо в конструктор. Ни один тест не должен уметь оплатить генерацию.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_BASE64 = Buffer.from(PNG).toString('base64');

function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function fail(status: number): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve('boom'),
  } as unknown as Response;
}

interface Scenario {
  provider: FusionBrainProvider;
  fetchMock: ReturnType<typeof vi.fn>;
  calls: () => string[];
}

function scenario(responses: Response[], deps: FusionBrainDeps = {}): Scenario {
  const urls: string[] = [];
  let index = 0;
  const fetchMock = vi.fn((url: string) => {
    urls.push(url);
    const res = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(res as Response);
  });

  const provider = new FusionBrainProvider({
    apiKey: 'key',
    secretKey: 'secret',
    fetch: fetchMock as unknown as FetchLike,
    pollIntervalMs: 0,
    sleep: () => Promise.resolve(),
    ...deps,
  });

  return { provider, fetchMock, calls: () => urls };
}

const PIPELINES = ok([{ id: 'pipe-1', name: 'Kandinsky' }]);
const STARTED = ok({ uuid: 'task-1', status: 'INITIAL' });
const DONE = ok({ status: 'DONE', result: { files: [PNG_BASE64], censored: false } });

describe('FusionBrainProvider', () => {
  it('проходит цепочку pipelines → run → status и отдаёт байты', async () => {
    const { provider, calls } = scenario([PIPELINES, STARTED, DONE]);

    const image = await provider.generate({ prompt: 'баннер', format: 'square_1080' });

    expect(image.data).toEqual(PNG);
    expect(image.mimeType).toBe('image/png');
    expect(image.provider).toBe('fusionbrain');
    expect(calls()[0]).toContain('key/api/v1/pipelines');
    expect(calls()[1]).toContain('key/api/v1/pipeline/run');
    expect(calls()[2]).toContain('key/api/v1/pipeline/status/task-1');
  });

  it('подгоняет размер под ограничения генератора: 1080 не бывает, бывает 1024', async () => {
    const { provider } = scenario([PIPELINES, STARTED, DONE]);
    const image = await provider.generate({ prompt: 'баннер', format: 'square_1080' });
    expect(image.width).toBe(1024);
    expect(image.height).toBe(1024);
  });

  it('шлёт ключи в заголовках X-Key и X-Secret', async () => {
    const { provider, fetchMock } = scenario([PIPELINES, STARTED, DONE]);
    await provider.generate({ prompt: 'баннер', format: 'banner_300x250' });

    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers['X-Key']).toBe('Key key');
    expect(init.headers['X-Secret']).toBe('Secret secret');
  });

  it('опрашивает статус, пока задача не готова', async () => {
    const processing = ok({ status: 'PROCESSING' });
    const { provider, fetchMock } = scenario([PIPELINES, STARTED, processing, processing, DONE]);

    await provider.generate({ prompt: 'баннер', format: 'story_9x16' });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('не повторяет платный запуск при ошибке — падает сразу', async () => {
    const { provider, fetchMock } = scenario([PIPELINES, fail(500)]);

    await expect(provider.generate({ prompt: 'баннер', format: 'square_1080' })).rejects.toThrow(
      /HTTP 500/u,
    );
    // pipelines + один run. Второго run быть не должно ни при каких условиях.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('FAIL от провайдера — это ошибка с причиной, а не пустая картинка', async () => {
    const failed = ok({ status: 'FAIL', errorDescription: 'censored prompt' });
    const { provider } = scenario([PIPELINES, STARTED, failed]);

    await expect(provider.generate({ prompt: 'баннер', format: 'square_1080' })).rejects.toThrow(
      /censored prompt/u,
    );
  });

  it('не дождавшись результата, сообщает id задачи — деньги уже потрачены', async () => {
    const processing = ok({ status: 'PROCESSING' });
    const { provider } = scenario([PIPELINES, STARTED, processing], { pollAttempts: 2 });

    await expect(
      provider.generate({ prompt: 'баннер', format: 'square_1080' }),
    ).rejects.toBeInstanceOf(ImageGenerationTimeoutError);
  });

  it('поддерживает ссылку вместо base64 в результате', async () => {
    const withUrl = ok({
      status: 'DONE',
      result: { files: ['https://cdn.example/img.png'], censored: false },
    });
    const download = {
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(PNG.buffer.slice(0)),
    } as unknown as Response;

    const { provider } = scenario([PIPELINES, STARTED, withUrl, download]);
    const image = await provider.generate({ prompt: 'баннер', format: 'square_1080' });
    expect(image.data.byteLength).toBe(PNG.byteLength);
  });

  it('прокидывает флаг цензуры наружу, а не молчит', async () => {
    const censored = ok({ status: 'DONE', result: { files: [PNG_BASE64], censored: true } });
    const { provider } = scenario([PIPELINES, STARTED, censored]);

    const image = await provider.generate({ prompt: 'баннер', format: 'square_1080' });
    expect(image.censored).toBe(true);
  });

  it('без ключей не ходит в сеть вообще', async () => {
    const { provider, fetchMock } = scenario([PIPELINES], { apiKey: '', secretKey: '' });

    await expect(
      provider.generate({ prompt: 'баннер', format: 'square_1080' }),
    ).rejects.toBeInstanceOf(ImageProviderNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(provider.isConfigured()).toBe(false);
  });

  it('список пайплайнов запрашивается один раз на инстанс', async () => {
    const { provider, calls } = scenario([PIPELINES, STARTED, DONE, STARTED, DONE]);

    await provider.generate({ prompt: 'a', format: 'square_1080' });
    // Второй прогон использует тот же ответ-заглушку: важно лишь число вызовов.
    await provider.generate({ prompt: 'b', format: 'square_1080' }).catch(() => undefined);

    expect(calls().filter((url) => url.endsWith('pipelines'))).toHaveLength(1);
  });

  it('неожиданная форма ответа — ошибка, а не молчаливый undefined', async () => {
    const { provider } = scenario([ok({ unexpected: true })]);
    await expect(provider.generate({ prompt: 'a', format: 'square_1080' })).rejects.toThrow(
      /pipelines/u,
    );
  });
});

describe('sniffMimeType', () => {
  it('различает png, jpeg и webp по сигнатуре', () => {
    expect(sniffMimeType(PNG)).toBe('image/png');
    expect(sniffMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMimeType(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBe('image/webp');
    expect(sniffMimeType(new Uint8Array([1, 2, 3, 4]))).toBe('application/octet-stream');
  });
});

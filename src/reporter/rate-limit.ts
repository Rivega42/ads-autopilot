/**
 * Подавление повторов алертов.
 *
 * Один сломанный кабинет генерирует ошибку на каждом вызове API: за пять минут
 * это сотни строк в `ErrorLog` и, без ограничителя, столько же сообщений в чат.
 * После такого чат перестают читать, и следующий настоящий инцидент проходит
 * незамеченным — поэтому ограничитель тут не про вежливость, а про то, чтобы
 * алерты вообще работали.
 *
 * Состояние держим в памяти процесса: под это нет таблицы в схеме, а выдумывать
 * миграцию ради счётчика нельзя. Плата — после рестарта воркера первый повтор
 * пройдёт. Это приемлемо: рестарт сам по себе редкое событие и обычно как раз
 * тот момент, когда алерт хочется увидеть.
 */

/** Сколько молчим по одному и тому же поводу. */
export const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

export class CooldownLimiter {
  private readonly lastSeen = new Map<string, number>();

  constructor(private readonly cooldownMs: number = DEFAULT_COOLDOWN_MS) {}

  /** true — по этому ключу давно не сообщали; вызов сразу засчитывает отправку. */
  allow(key: string, now: Date = new Date()): boolean {
    const at = now.getTime();
    const previous = this.lastSeen.get(key);
    if (previous !== undefined && at - previous < this.cooldownMs) return false;
    this.lastSeen.set(key, at);
    this.prune(at);
    return true;
  }

  /** Остаток тишины по ключу, мс. 0 — можно слать. */
  remainingMs(key: string, now: Date = new Date()): number {
    const previous = this.lastSeen.get(key);
    if (previous === undefined) return 0;
    return Math.max(0, this.cooldownMs - (now.getTime() - previous));
  }

  reset(): void {
    this.lastSeen.clear();
  }

  get size(): number {
    return this.lastSeen.size;
  }

  /** Ключи живут ровно столько, сколько длится тишина: иначе карта растёт вечно. */
  private prune(at: number): void {
    for (const [key, seenAt] of this.lastSeen) {
      if (at - seenAt >= this.cooldownMs) this.lastSeen.delete(key);
    }
  }
}

/** Общий ограничитель прогона алертов. Тесты создают свой и не трогают этот. */
export const alertLimiter = new CooldownLimiter();

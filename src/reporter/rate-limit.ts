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

interface Entry {
  at: number;
  /** Своя длительность тишины: у поводов разный «естественный» период повтора. */
  cooldownMs: number;
}

export class CooldownLimiter {
  private readonly lastSeen = new Map<string, Entry>();

  constructor(private readonly cooldownMs: number = DEFAULT_COOLDOWN_MS) {}

  /**
   * Проверка без побочного эффекта.
   *
   * Отделена от отметки намеренно: раньше фильтрация сразу засчитывала
   * отправку, и алерт, который не влез в лимит прогона или не ушёл из-за
   * упавшего Telegram, замолкал на весь период тишины, ни разу не доехав.
   */
  isAllowed(key: string, now: Date = new Date()): boolean {
    return this.remainingMs(key, now) === 0;
  }

  /** Засчитывает доставку. Вызывать только после того, как сообщение реально ушло. */
  markSent(key: string, now: Date = new Date(), cooldownMs?: number): void {
    const at = now.getTime();
    this.lastSeen.set(key, { at, cooldownMs: cooldownMs ?? this.cooldownMs });
    this.prune(at);
  }

  /** Проверка вместе с отметкой — для поводов, у которых нет отдельной доставки. */
  allow(key: string, now: Date = new Date(), cooldownMs?: number): boolean {
    if (!this.isAllowed(key, now)) return false;
    this.markSent(key, now, cooldownMs);
    return true;
  }

  /** Остаток тишины по ключу, мс. 0 — можно слать. */
  remainingMs(key: string, now: Date = new Date()): number {
    const previous = this.lastSeen.get(key);
    if (previous === undefined) return 0;
    return Math.max(0, previous.cooldownMs - (now.getTime() - previous.at));
  }

  reset(): void {
    this.lastSeen.clear();
  }

  get size(): number {
    return this.lastSeen.size;
  }

  /** Ключи живут ровно столько, сколько длится тишина: иначе карта растёт вечно. */
  private prune(at: number): void {
    for (const [key, entry] of this.lastSeen) {
      if (at - entry.at >= entry.cooldownMs) this.lastSeen.delete(key);
    }
  }
}

/** Общий ограничитель прогона алертов. Тесты создают свой и не трогают этот. */
export const alertLimiter = new CooldownLimiter();

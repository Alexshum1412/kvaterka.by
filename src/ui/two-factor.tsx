'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';

/**
 * Setting up and answering a second factor.
 *
 * The QR code is drawn here rather than fetched, because fetching one means
 * sending the secret to somebody else's image service. It is a handful of
 * rectangles in an SVG — a real dependency and a real third party avoided for
 * about eighty lines.
 *
 * The recovery codes are shown once and the screen says so before it shows
 * them, not after. A person who has already clicked past a list they were told
 * afterwards was irreplaceable has learned something useless.
 */

/* ------------------------------------------------------------------ *
 * A minimal QR encoder
 * ------------------------------------------------------------------ */

/**
 * Byte-mode QR, version 6 with error correction L, which comfortably holds the
 * ~120 characters of an otpauth URI. Not a general encoder: it handles exactly
 * the one case this screen needs, and refuses anything longer rather than
 * producing a code that scans to the wrong thing.
 */
function qrMatrix(text: string): boolean[][] | null {
  const data = new TextEncoder().encode(text);
  const VERSION = 6;
  const SIZE = 17 + VERSION * 4; // 41
  const CAPACITY = 134; // version 6-L byte mode
  if (data.length > CAPACITY) return null;

  /* --- bit stream --- */
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(data.length, 8 + (VERSION >= 10 ? 8 : 0));
  for (const byte of data) push(byte, 8);

  const totalCodewords = 136; // version 6-L data codewords
  push(0, Math.min(4, totalCodewords * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  }
  const PAD = [0xec, 0x11];
  for (let i = 0; codewords.length < totalCodewords; i += 1) codewords.push(PAD[i % 2]!);

  /* --- Reed–Solomon --- */
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!;
  const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

  const ecCount = 16; // version 6-L
  let generator = [1];
  for (let i = 0; i < ecCount; i += 1) {
    const next = new Array(generator.length + 1).fill(0);
    for (let j = 0; j < generator.length; j += 1) {
      next[j] ^= mul(generator[j]!, EXP[i]!);
      next[j + 1] ^= generator[j]!;
    }
    generator = next;
  }

  const remainder = [...codewords, ...new Array(ecCount).fill(0)];
  for (let i = 0; i < codewords.length; i += 1) {
    const factor = remainder[i]!;
    if (factor === 0) continue;
    for (let j = 0; j < generator.length; j += 1) {
      remainder[i + j] = remainder[i + j]! ^ mul(generator[j]!, factor);
    }
  }
  const all = [...codewords, ...remainder.slice(codewords.length)];

  /* --- matrix --- */
  const m: (boolean | null)[][] = Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));
  const setFinder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) continue;
        const on =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        m[rr]![cc] = on;
      }
    }
  };
  setFinder(0, 0);
  setFinder(0, SIZE - 7);
  setFinder(SIZE - 7, 0);

  // Alignment pattern (version 6: centre 34,34).
  for (let r = -2; r <= 2; r += 1) {
    for (let c = -2; c <= 2; c += 1) {
      m[34 + r]![34 + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
    }
  }

  for (let i = 8; i < SIZE - 8; i += 1) {
    m[6]![i] = i % 2 === 0;
    m[i]![6] = i % 2 === 0;
  }
  m[SIZE - 8]![8] = true;

  // Reserve format areas.
  for (let i = 0; i < 9; i += 1) {
    if (m[8]![i] === null) m[8]![i] = false;
    if (m[i]![8] === null) m[i]![8] = false;
  }
  for (let i = SIZE - 8; i < SIZE; i += 1) {
    if (m[8]![i] === null) m[8]![i] = false;
    if (m[i]![8] === null) m[i]![8] = false;
  }

  /* --- place data, mask 0 --- */
  let bitIndex = 0;
  const nextBit = (): number => {
    const byte = all[bitIndex >> 3];
    if (byte === undefined) return 0;
    const bit = (byte >>> (7 - (bitIndex & 7))) & 1;
    bitIndex += 1;
    return bit;
  };
  let upward = true;
  for (let col = SIZE - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let i = 0; i < SIZE; i += 1) {
      const row = upward ? SIZE - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (m[row]![c] !== null) continue;
        const bit = nextBit();
        // Mask pattern 0: (row + col) % 2 === 0
        m[row]![c] = ((row + c) % 2 === 0 ? bit ^ 1 : bit) === 1;
      }
    }
    upward = !upward;
  }

  /* --- format information: EC level L, mask 0 --- */
  const FORMAT = 0b111011111000100;
  const formatBit = (i: number) => ((FORMAT >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) m[8]![i] = formatBit(i);
  m[8]![7] = formatBit(6);
  m[8]![8] = formatBit(7);
  m[7]![8] = formatBit(8);
  for (let i = 9; i <= 14; i += 1) m[14 - i]![8] = formatBit(i);
  for (let i = 0; i <= 7; i += 1) m[SIZE - 1 - i]![8] = formatBit(i);
  for (let i = 8; i <= 14; i += 1) m[8]![SIZE - 15 + i] = formatBit(i);

  return m.map((row) => row.map((cell) => cell === true));
}

function QrCode({ text }: { text: string }) {
  const matrix = qrMatrix(text);
  if (!matrix) return null;
  const size = matrix.length;
  const quiet = 4;
  const total = size + quiet * 2;

  return (
    <svg
      viewBox={`0 0 ${total} ${total}`}
      width="220"
      height="220"
      role="img"
      aria-label="QR-код для приложения-аутентификатора"
      className="tfa__qr"
    >
      <rect width={total} height={total} fill="#fff" />
      {matrix.flatMap((row, r) =>
        row.map((on, c) =>
          on ? <rect key={`${r}-${c}`} x={c + quiet} y={r + quiet} width={1} height={1} fill="#12203a" /> : null,
        ),
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Enrolment
 * ------------------------------------------------------------------ */

interface EnrolState {
  secret: string;
  uri: string;
}

export function TwoFactorSetup({ enrolled, required }: { enrolled: boolean; required: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<'IDLE' | 'SCAN' | 'CODES'>('IDLE');
  const [enrolment, setEnrolment] = useState<EnrolState | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (enrolled && step !== 'CODES') {
    return (
      <section className="card tfa__done">
        <Icon name="checkCircle" size={20} />
        <div>
          <h2>Двухфакторная проверка включена</h2>
          <p>При входе вы будете вводить код из приложения-аутентификатора.</p>
        </div>
      </section>
    );
  }

  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<EnrolState>('/me/2fa/enrol', {});
      setEnrolment(res);
      setStep('SCAN');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось начать настройку');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ recoveryCodes: string[] }>('/me/2fa/confirm', { code: code.trim() });
      setCodes(res.recoveryCodes);
      setStep('CODES');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось подтвердить код');
    } finally {
      setBusy(false);
    }
  };

  if (step === 'CODES') {
    return (
      <section className="card tfa__codes">
        <h2 className="tfa__h2">Сохраните резервные коды</h2>
        {/* Said BEFORE the list, not after: a person who has already clicked
            past something they are then told was irreplaceable has learned
            nothing useful. */}
        <p className="tfa__warn">
          <Icon name="alert" size={16} />
          Мы показываем эти коды один раз. Мы храним только их отпечатки и не сможем показать их снова.
          Каждый код срабатывает один раз — держите их там же, где храните пароли.
        </p>
        <ul className="tfa__codeList">
          {codes.map((c) => (
            <li key={c}>
              <code>{c}</code>
            </li>
          ))}
        </ul>
        <label className="tfa__confirmSaved">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          Я сохранил коды в надёжном месте
        </label>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!saved}
          onClick={() => {
            router.push('/staff');
            router.refresh();
          }}
        >
          Готово
        </button>
      </section>
    );
  }

  if (step === 'SCAN' && enrolment) {
    return (
      <section className="card">
        <h2 className="tfa__h2">Отсканируйте код</h2>
        <p className="tfa__muted">
          Откройте приложение-аутентификатор — например, то, которым вы уже пользуетесь для рабочей почты, — и
          отсканируйте картинку. Затем введите шестизначный код, который оно покажет.
        </p>

        <div className="tfa__scan">
          <QrCode text={enrolment.uri} />
          {/* Visible, not tucked behind a disclosure. Scanning depends on a
              camera, the lighting and the app; typing sixteen characters
              always works, and a person stuck at this step with no obvious
              alternative simply gives up. */}
          <div className="tfa__manual">
            <p>Или введите ключ вручную:</p>
            <code className="tfa__secret">{enrolment.secret}</code>
          </div>
        </div>

        <form onSubmit={confirm} className="tfa__form">
          <label className="field">
            <span className="field__label">Код из приложения</span>
            <input
              className="input tfa__code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              required
            />
          </label>
          {error && (
            <p className="tfa__error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn--primary" disabled={busy || code.trim().length < 6}>
            {busy ? 'Проверяем…' : 'Подтвердить'}
          </button>
        </form>
      </section>
    );
  }

  return (
    <section className="card">
      <h2 className="tfa__h2">Включить двухфакторную проверку</h2>
      <p className="tfa__muted">
        {required
          ? 'Для служебного доступа нужен второй фактор: пароля недостаточно, чтобы открыть обращения, документы или финансовые данные. Пока он не настроен, служебные разделы недоступны — ваш обычный аккаунт работает как прежде.'
          : 'Дополнительная защита аккаунта: при входе понадобится код из приложения.'}
      </p>
      {error && (
        <p className="tfa__error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="btn btn--primary" onClick={begin} disabled={busy}>
        {busy ? 'Готовим…' : 'Настроить'}
      </button>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * The challenge
 * ------------------------------------------------------------------ */

export function TwoFactorChallenge({ next = '/staff' }: { next?: string }) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="card">
      <h2 className="tfa__h2">Подтвердите вход</h2>
      <p className="tfa__muted">
        Введите код из приложения-аутентификатора. Если телефона под рукой нет — введите один из резервных кодов.
      </p>
      <form
        className="tfa__form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.post('/me/2fa/challenge', { code: code.trim() });
            router.push(next);
            router.refresh();
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Не удалось подтвердить код');
            setBusy(false);
          }
        }}
      >
        <label className="field">
          <span className="field__label">Код</span>
          <input
            className="input tfa__code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            required
            autoFocus
          />
        </label>
        {error && (
          <p className="tfa__error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn--primary" disabled={busy || code.trim().length < 6}>
          {busy ? 'Проверяем…' : 'Подтвердить'}
        </button>
      </form>
    </section>
  );
}

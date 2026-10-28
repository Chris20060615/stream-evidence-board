// Only the local typed-review step. No account, network, credential or host
// dependency is available here. Invalid text is never returned or echoed.
export function confirmOwnChannel({ reader, signal, channelLogin, onInvalid = () => {}, timeoutMs = 300_000 }) {
  if (!reader || typeof reader.on !== 'function' || typeof reader.removeListener !== 'function'
    || !(signal instanceof AbortSignal) || !/^[a-z0-9_]{1,25}$/.test(channelLogin ?? '')
    || typeof onInvalid !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error('invalid_confirmation_configuration');
  }
  const expected = `START ${channelLogin}`;
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reader.removeListener('line', line);
      reader.removeListener('close', closed);
      signal.removeEventListener('abort', cancelled);
      resolve(Object.freeze({ ok: code === 'confirmation_accepted', code }));
    };
    const closed = () => finish('confirmation_input_closed');
    const cancelled = () => finish('confirmation_cancelled');
    const line = (value) => {
      if (signal.aborted) return cancelled();
      if (reader.closed === true) return closed();
      if (Date.now() >= deadline) return finish('confirmation_timeout');
      const text = typeof value === 'string' ? value.trim() : '';
      if (text === expected) return finish('confirmation_accepted');
      if (text === 'CANCEL') return cancelled();
      try { onInvalid(); } catch { finish('confirmation_unavailable'); }
    };
    const timer = setTimeout(() => finish('confirmation_timeout'), timeoutMs);
    reader.on('line', line);
    reader.once('close', closed);
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) cancelled();
    else if (reader.closed === true) closed();
  });
}

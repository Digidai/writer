const STUB = new URL('./cloudflare-workers.js', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: STUB, shortCircuit: true };
  return next(specifier, context);
}

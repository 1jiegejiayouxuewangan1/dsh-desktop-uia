/** Redirect the harness tool package to the local stub. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: new URL('./dsh-tools-stub.mjs', import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

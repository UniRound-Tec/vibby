export function supportsCodexHooks (features: string|null): boolean {
    return !!features && /^\s*hooks\s+stable\s+true\s*$/im.test(features)
}

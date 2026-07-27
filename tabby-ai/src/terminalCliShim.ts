import { DetectedCli } from './api'
import { quoteCmd, quoteSh } from './paths'

function validatePassthrough (values: string[]): void {
    if (values.some(value => !/^[A-Za-z0-9_-]+$/.test(value))) {
        throw new Error('unsafe shim passthrough subcommand')
    }
}

export function buildWindowsCliShim (
    detected: DetectedCli,
    args: string[],
    env: Record<string, string>,
    passthroughSubcommands: string[],
): string {
    validatePassthrough(passthroughSubcommands)
    const command = quoteCmd(detected.command)
    const forwarded = args.map(arg => quoteCmd(arg)).join(' ')
    const baseInvocation = detected.launcher === 'cmd'
        ? `call ${command}`
        : detected.launcher === 'ps1'
            ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${command}`
            : command
    const invocation = detected.launcher === 'cmd'
        ? `call ${command} ${forwarded} %*`
        : detected.launcher === 'ps1'
            ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${command} ${forwarded} %*`
            : `${command} ${forwarded} %*`
    const checks = passthroughSubcommands
        .map(value => `if /I "%~1"=="${value}" goto vibby_passthrough`)
        .join('\r\n')
    const envLines = Object.entries(env).map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n\0"]/.test(value)) {
            throw new Error(`unsafe shim environment entry: ${key}`)
        }
        return `set "${key}=${value.replace(/%/g, '%%')}"`
    }).join('\r\n')
    return [
        '@echo off',
        checks,
        envLines,
        invocation.trim(),
        'exit /b %ERRORLEVEL%',
        ':vibby_passthrough',
        `${baseInvocation} %*`,
    ].filter(Boolean).join('\r\n') + '\r\n'
}

export function buildPosixCliShim (
    detected: DetectedCli,
    args: string[],
    env: Record<string, string>,
    passthroughSubcommands: string[],
): string {
    validatePassthrough(passthroughSubcommands)
    const passthrough = [
        quoteSh(detected.command),
        '"$@"',
    ].join(' ')
    const invocation = [
        ...Object.entries(env).map(([key, value]) => {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
                throw new Error(`unsafe shim environment key: ${key}`)
            }
            return `${key}=${quoteSh(value)}`
        }),
        quoteSh(detected.command),
        ...args.map(arg => quoteSh(arg)),
        '"$@"',
    ].join(' ')
    const cases = passthroughSubcommands.length
        ? `case "\${1-}" in\n    ${passthroughSubcommands.join('|')}) exec ${passthrough} ;;\nesac\n`
        : ''
    return `#!/bin/sh\n${cases}exec ${invocation}\n`
}

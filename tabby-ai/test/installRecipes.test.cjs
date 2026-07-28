const assert = require('node:assert/strict')
const {
    CLI_INSTALL_RECIPES,
    installPlatformFor,
    installRecipeFor,
    installShellCommand,
    installShellEnvironment,
    installPlatformForTarget,
} = require('../.test-build/installRecipes.js')

assert.equal(installPlatformFor('win32'), 'windows')
assert.equal(installPlatformFor('darwin'), 'macos')
assert.equal(installPlatformFor('linux'), 'linux')
assert.equal(installPlatformFor('freebsd'), null)

const recipe = {
    command: 'npm install -g example-cli',
    sourceUrl: 'https://example.com/install',
    support: 'ready',
}

assert.deepEqual(installShellCommand(recipe, 'linux'), {
    command: '/bin/sh',
    args: ['-lc', recipe.command],
})
assert.equal(installShellCommand(recipe, 'windows').command, 'powershell.exe')
assert.ok(installShellCommand(recipe, 'windows').args.includes('-Command'))
assert.equal(installRecipeFor('missing-cli', 'windows'), null)
assert.deepEqual(
    installShellEnvironment({ PATH: 'C:\\Tools', SAMPLE: 'value' }, 'windows'),
    { PATH: 'C:\\Tools', SAMPLE: 'value' },
)
assert.deepEqual(
    installShellEnvironment({
        PATH: 'C:\\Tools',
        PSModulePath: 'C:\\Program Files\\PowerShell\\Modules',
        psmodulepath: 'C:\\shadowed-modules',
    }, 'windows'),
    { PATH: 'C:\\Tools' },
    'Windows PowerShell must rebuild its own module path',
)
assert.deepEqual(
    installShellEnvironment({ PATH: '/usr/bin', PSModulePath: '/custom/modules' }, 'linux'),
    { PATH: '/usr/bin', PSModulePath: '/custom/modules' },
    'non-Windows installers preserve the caller environment',
)
assert.deepEqual(
    installShellEnvironment({
        PATH: 'C:\\Tools',
        npm_config_argv: '{}',
        NPM_CONFIG_VERSION_COMMIT_HOOKS: 'true',
        npm_config_version_git_message: 'v%s',
        npm_config_version_git_sign: '',
        npm_config_version_git_tag: 'true',
        npm_config_version_tag_prefix: 'v',
        npm_config_registry: 'https://registry.example.com',
        npm_config_proxy: 'http://proxy.example.com',
        npm_config_strict_ssl: 'false',
    }, 'windows'),
    {
        PATH: 'C:\\Tools',
        npm_config_registry: 'https://registry.example.com',
        npm_config_proxy: 'http://proxy.example.com',
        npm_config_strict_ssl: 'false',
    },
    'Yarn lifecycle metadata is removed while user npm networking config is preserved',
)

const expectedCliIds = [
    'amp',
    'antigravity-cli',
    'claude-code',
    'cline',
    'codex',
    'crush',
    'cursor-agent',
    'devin-cli',
    'factory-droid',
    'github-copilot',
    'grok-build',
    'kilo-code',
    'kimi-code',
    'kiro-cli',
    'opencode',
    'pi',
    'qwen-code',
]
assert.deepEqual(Object.keys(CLI_INSTALL_RECIPES).sort(), expectedCliIds)
for (const cliId of expectedCliIds) {
    for (const platform of ['windows', 'macos', 'linux']) {
        const platformRecipe = installRecipeFor(cliId, platform)
        assert.ok(platformRecipe, `${cliId}/${platform}`)
        assert.match(platformRecipe.sourceUrl, /^https:\/\//)
        if (platformRecipe.support === 'ready') {
            assert.ok(platformRecipe.command, `${cliId}/${platform} ready command`)
        } else {
            assert.equal(platformRecipe.command, undefined, `${cliId}/${platform} guided command`)
        }
    }
}
assert.equal(installRecipeFor('cursor-agent', 'windows').support, 'requires-wsl')
assert.equal(installPlatformForTarget({ platform: 'linux' }), 'linux')
assert.equal(installPlatformForTarget(null), null)
assert.equal('aider' in CLI_INSTALL_RECIPES, false)

console.log('installRecipes.test.cjs: all assertions passed')

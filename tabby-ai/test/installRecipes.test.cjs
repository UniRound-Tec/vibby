const assert = require('node:assert/strict')
const {
    CLI_INSTALL_RECIPES,
    installPlatformFor,
    installRecipeFor,
    installShellCommand,
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

const expectedCliIds = [
    'amp',
    'antigravity-cli',
    'claude-code',
    'cline',
    'codex',
    'continue-cli',
    'crush',
    'cursor-agent',
    'devin-cli',
    'factory-droid',
    'gemini-cli',
    'github-copilot',
    'goose',
    'grok-build',
    'kilo-code',
    'kimi-code',
    'kiro-cli',
    'opencode',
    'openhands',
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
assert.equal(installRecipeFor('openhands', 'windows').support, 'requires-wsl')
assert.equal(installRecipeFor('goose', 'windows').support, 'guided')
assert.equal('aider' in CLI_INSTALL_RECIPES, false)

console.log('installRecipes.test.cjs: all assertions passed')

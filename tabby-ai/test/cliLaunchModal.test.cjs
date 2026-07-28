const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const ts = require('typescript')

function loadTypeScriptModule (filename) {
    const source = fs.readFileSync(filename, 'utf8')
    const output = ts.transpileModule(source, {
        compilerOptions: {
            esModuleInterop: true,
            experimentalDecorators: true,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
        },
        fileName: filename,
    }).outputText
    const loaded = new Module(filename, module)
    loaded.filename = filename
    loaded.paths = Module._nodeModulePaths(path.dirname(filename))
    loaded._compile(output, filename)
    return loaded.exports
}

const filename = path.resolve(__dirname, '../src/components/cliLaunchModal.component.ts')
const {
    CliLaunchModalComponent,
    linuxPathFromWslPicker,
} = loadTypeScriptModule(filename)

async function testWslDirectoryPicker () {
    const pickerCalls = []
    const platform = {
        pickDirectory: async (...args) => {
            pickerCalls.push(args)
            return '\\\\wsl.localhost\\Ubuntu-22.04\\home\\jesse\\project'
        },
    }
    const component = new CliLaunchModalComponent({}, platform)
    component.targets = [{
        id: 'wsl:Ubuntu-22.04',
        label: 'Ubuntu-22.04',
        detail: '',
        type: 'wsl',
        wslDistribution: 'Ubuntu-22.04',
    }]
    component.selectedTargetId = 'wsl:Ubuntu-22.04'

    await component.pickWorkingDirectory()

    assert.equal(
        component.cwd,
        '/home/jesse/project',
        'a directory selected through the Windows WSL share must become a Linux path',
    )
    assert.ok(
        pickerCalls.flat(Infinity).some(value =>
            typeof value === 'string' && value.includes('\\\\wsl$\\Ubuntu-22.04'),
        ),
        'the WSL picker must open inside the selected distribution',
    )
}

function testWslPickerPathVariants () {
    assert.equal(
        linuxPathFromWslPicker('Ubuntu-22.04', '\\\\wsl$\\Ubuntu-22.04\\home\\jesse'),
        '/home/jesse',
    )
    assert.equal(
        linuxPathFromWslPicker('Ubuntu-22.04', '\\\\wsl.localhost\\Ubuntu-22.04'),
        '/',
    )
    assert.equal(
        linuxPathFromWslPicker('Ubuntu-22.04', 'C:\\Users\\Jesse'),
        null,
    )
}

testWslPickerPathVariants()
testWslDirectoryPicker().then(() => {
    console.log('cliLaunchModal.test.cjs: all assertions passed')
})

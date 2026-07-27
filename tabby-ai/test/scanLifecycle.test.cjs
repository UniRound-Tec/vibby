const assert = require('node:assert/strict')
const { scanResultForProfiles } = require('../.test-build/scanLifecycle.js')

void (async () => {
    let starts = 0
    const fresh = await scanResultForProfiles(null, null, ['unused'], async () => {
        starts++
        return ['fresh']
    })
    assert.deepEqual(fresh, ['fresh'])
    assert.equal(starts, 1)

    const running = Promise.resolve(['running'])
    assert.deepEqual(
        await scanResultForProfiles(running, Promise.resolve(['old']), ['latest'], async () => ['unexpected']),
        ['running'],
    )
    assert.deepEqual(
        await scanResultForProfiles(null, Promise.resolve(['old']), ['latest'], async () => ['unexpected']),
        ['latest'],
        'profile providers use the latest completed rescan, not the first scan snapshot',
    )

    console.log('scanLifecycle.test.cjs: all assertions passed')
})()

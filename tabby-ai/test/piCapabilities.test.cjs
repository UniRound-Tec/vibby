const assert = require('node:assert/strict')
const {
    MINIMUM_PI_MONITORING_VERSION,
    supportsPiMonitoring,
} = require('../.test-build/piCapabilities.js')

assert.equal(MINIMUM_PI_MONITORING_VERSION, '0.82.1')
assert.equal(supportsPiMonitoring('0.82.0'), false)
assert.equal(supportsPiMonitoring('0.82.1'), true)
assert.equal(supportsPiMonitoring('v0.83.0'), true)
assert.equal(supportsPiMonitoring('1.0.0'), true)
assert.equal(supportsPiMonitoring('0.81.9'), false)
assert.equal(supportsPiMonitoring('0.82.1-beta.1'), false)
assert.equal(supportsPiMonitoring('0.82.1+build.1'), true)
assert.equal(supportsPiMonitoring(null), false)
assert.equal(supportsPiMonitoring('unknown'), false)

console.log('piCapabilities.test.cjs: all assertions passed')

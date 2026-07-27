const assert = require('node:assert/strict')
const {
    MIN_LAUNCH_PAGE_CAPACITY,
    launchPageCapacity,
} = require('../.test-build/launchPagination.js')

assert.equal(MIN_LAUNCH_PAGE_CAPACITY, 8)
assert.equal(launchPageCapacity(5), 10, 'five columns fill two rows')
assert.equal(launchPageCapacity(4), 8, 'four columns keep the existing density')
assert.equal(launchPageCapacity(3), 9, 'three columns fill three rows')
assert.equal(launchPageCapacity(2), 8, 'two columns fill four rows')
assert.equal(launchPageCapacity(1), 8, 'one column keeps eight rows')
assert.equal(launchPageCapacity(0), 8, 'invalid measurements fall back safely')

console.log('launchPagination.test.cjs: all assertions passed')

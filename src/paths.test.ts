/* eslint-disable no-process-env -- the tests configure the paths through env vars */
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { assertDirectoriesDoNotOverlap, bookWorkDir } from './paths'

const original = { ...process.env }

afterEach(() => {
  process.env = { ...original }
})

describe('assertDirectoriesDoNotOverlap', () => {
  test('accepts separate directories', () => {
    process.env.WORK_DIR = '/tmp/work'
    process.env.OUTPUT_DIR = '/tmp/books'
    expect(() => assertDirectoriesDoNotOverlap()).not.toThrow()
  })

  test('refuses identical directories', () => {
    // finalize-book moves results into OUTPUT_DIR and then deletes WORK_DIR —
    // if they are the same, that deletes the finished books.
    process.env.WORK_DIR = '/tmp/same'
    process.env.OUTPUT_DIR = '/tmp/same'
    expect(() => assertDirectoriesDoNotOverlap()).toThrow(/must not overlap/)
  })

  test('refuses an output directory inside the work directory', () => {
    process.env.WORK_DIR = '/tmp/work'
    process.env.OUTPUT_DIR = '/tmp/work/books'
    expect(() => assertDirectoriesDoNotOverlap()).toThrow(/must not overlap/)
  })

  test('refuses a work directory inside the output directory', () => {
    process.env.WORK_DIR = '/tmp/books/work'
    process.env.OUTPUT_DIR = '/tmp/books'
    expect(() => assertDirectoriesDoNotOverlap()).toThrow(/must not overlap/)
  })

  test('is not fooled by a shared name prefix', () => {
    process.env.WORK_DIR = '/tmp/books-work'
    process.env.OUTPUT_DIR = '/tmp/books'
    expect(() => assertDirectoriesDoNotOverlap()).not.toThrow()
  })
})

describe('bookWorkDir', () => {
  test('stays inside the work directory for a real ASIN', () => {
    process.env.WORK_DIR = '/tmp/work'
    expect(bookWorkDir('B07QLY87NH')).toBe(path.join('/tmp/work', 'B07QLY87NH'))
  })

  test('expands a leading tilde', () => {
    process.env.WORK_DIR = '~/kindle-work'
    expect(bookWorkDir('B07QLY87NH')).toBe(
      path.join(os.homedir(), 'kindle-work', 'B07QLY87NH')
    )
  })
})

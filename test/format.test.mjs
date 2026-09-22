import assert from 'node:assert/strict'
import test from 'node:test'

import { diffSnapshots, elementLine, flattenTree, renderDiff, renderTree, windowLabel } from '../lib/format.js'
import { sampleSnapshot } from './helpers/fakes.mjs'

test('elementLine prints id, type, name, patterns, rect and flags', () => {
  const line = elementLine({
    id: 'el_7',
    type: 'Button',
    name: '保存',
    aid: 'saveButton',
    patterns: ['invoke', 'scrollItem'],
    rect: { x: 10, y: 20, w: 60, h: 24 },
    enabled: false,
    offscreen: true,
  })
  assert.match(line, /^\[el_7\] Button "保存"/u)
  assert.match(line, /aid=saveButton/u)
  assert.match(line, /can=\[invoke,scrollTo\]/u)
  assert.match(line, /rect=10,20 60x24/u)
  assert.match(line, /\(disabled offscreen\)/u)
})

test('elementLine keeps a name-less element readable', () => {
  assert.equal(elementLine({ id: 'el_3', type: 'Pane' }), '[el_3] Pane')
})

test('renderTree indents by depth and reports truncation', () => {
  const { tree } = sampleSnapshot()
  const { lines, truncated } = renderTree(tree)
  assert.equal(truncated, false)
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^\[el_1\] Window "记事本"/u)
  assert.match(lines[1], /^ {2}\[el_2\] Button "保存"/u)

  const capped = renderTree(tree, { maxLines: 1 })
  assert.equal(capped.truncated, true)
  assert.equal(capped.lines.length, 1)
})

test('flattenTree records parent links', () => {
  const { tree } = sampleSnapshot()
  const flat = flattenTree(tree)
  assert.deepEqual(flat.map((element) => element.id), ['el_1', 'el_2'])
  assert.equal(flat[0].parentId, null)
  assert.equal(flat[1].parentId, 'el_1')
  assert.equal(flat[0].children, undefined)
})

test('diffSnapshots treats a first capture as new', () => {
  const diff = diffSnapshots(undefined, sampleSnapshot())
  assert.equal(diff.first, true)
  assert.equal(diff.added, 2)
  assert.equal(renderDiff(diff), 'initial snapshot: 2 elements')
})

test('diffSnapshots reports added, removed, changed and identical snapshots', () => {
  const before = sampleSnapshot()
  assert.equal(renderDiff(diffSnapshots(before, structuredClone(before))), 'no structural change')

  const moved = structuredClone(before)
  moved.tree.children[0].rect.x = 99
  const movedDiff = diffSnapshots(before, moved)
  assert.equal(movedDiff.changed, 1)
  assert.equal(movedDiff.added, 0)
  assert.match(renderDiff(movedDiff), /changed: \+0 -0 ~1/u)
  assert.match(renderDiff(movedDiff), /^~ \[el_2\]/mu)

  const grown = structuredClone(before)
  grown.tree.children.push({ id: 'el_9', type: 'MenuItem', name: '文件' })
  const grownDiff = diffSnapshots(before, grown)
  assert.equal(grownDiff.added, 1)
  assert.match(renderDiff(grownDiff), /^\+ \[el_9\] MenuItem "文件"$/mu)

  const shrunk = structuredClone(before)
  shrunk.tree.children = []
  const shrunkDiff = diffSnapshots(before, shrunk)
  assert.equal(shrunkDiff.removed, 1)
  assert.match(renderDiff(shrunkDiff), /^- \[el_2\]/mu)
})

test('windowLabel names the process and tolerates a missing title', () => {
  assert.equal(windowLabel({ title: '记事本', process: 'notepad', pid: 111 }), '"记事本" (notepad pid=111)')
  assert.equal(windowLabel({}), '(untitled) (unknown process)')
  assert.equal(windowLabel(null), '(unknown window)')
})

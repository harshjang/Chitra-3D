import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as config from './photo-scene-config'

describe('Photo Scene Pipeline No Hardcoding Policy', () => {
  const agentOpsDir = path.resolve(__dirname)

  test('photo-scene-config exports only numbers and contains no room or furniture knowledge', () => {
    for (const [key, value] of Object.entries(config)) {
      expect(typeof value).toBe('number')
      expect(key.toLowerCase()).not.toMatch(
        /bedroom|kitchen|bathroom|dorm|livingroom|sofa|bed|chair|table|desk|wardrobe|dresser/,
      )
    }
  })

  test('pipeline files contain no per-category regex tables or hardcoded asset IDs', () => {
    const filesToCheck = [
      'photo-scene-assets.ts',
      'photo-scene-executor.ts',
      'photo-object-fit.ts',
      'photo-scene-config.ts',
    ]
    for (const filename of filesToCheck) {
      const filePath = path.join(agentOpsDir, filename)
      if (!fs.existsSync(filePath)) continue
      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content, `${filename}: no hex colour map`).not.toMatch(
        /slot_body:\s*'#[0-9a-fA-F]{6}'/,
      )
      expect(content, `${filename}: no slot_cushion`).not.toMatch(
        /slot_cushion:\s*'#[0-9a-fA-F]{6}'/,
      )
      expect(content, `${filename}: no compatibility regex table`).not.toMatch(
        /compatibility:\s*Record<.*RegExp>/,
      )
      expect(content, `${filename}: no sofa asset id check`).not.toMatch(
        /asset\.id\s*===\s*['"]sofa['"]/,
      )
      expect(content, `${filename}: no coffee-table asset id`).not.toMatch(
        /asset\.id\s*===\s*['"]coffee-table['"]/,
      )
      expect(content, `${filename}: no STACKABLE_CATEGORIES`).not.toMatch(/STACKABLE_CATEGORIES/)
      expect(content, `${filename}: no STANDARD_SIZE_CATEGORIES`).not.toMatch(
        /STANDARD_SIZE_CATEGORIES/,
      )
      expect(content, `${filename}: no WALL_MOUNTED_CATEGORIES`).not.toMatch(
        /WALL_MOUNTED_CATEGORIES/,
      )
    }
  })

  test('vision adapter prompt contains no hardcoded example measurements or closed category list', () => {
    const adapterPath = path.join(agentOpsDir, 'photo-scene-vision-adapter.ts')
    if (!fs.existsSync(adapterPath)) return
    const content = fs.readFileSync(adapterPath, 'utf-8')
    expect(content).not.toMatch(/"wallHeight":\s*2\.7/)
    expect(content).not.toMatch(/"wallThickness":\s*0\.12/)
    // The closed vocabulary list ("category must be exactly one of: picture, ...") must not appear
    expect(content).not.toMatch(/category must be exactly one of:/)
    // No hardcoded example object id
    expect(content).not.toMatch(/"sofa-1"/)
  })

  test('executor contains no rug special-casing', () => {
    const execPath = path.join(agentOpsDir, 'photo-scene-executor.ts')
    if (!fs.existsSync(execPath)) return
    const content = fs.readFileSync(execPath, 'utf-8')
    expect(content).not.toMatch(/category\s*===\s*['"]rug['"]/)
  })
})

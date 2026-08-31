import { describe, expect, it } from "vitest"

import { generateBookDirectorySlug } from "../src/main/book-path.js"

describe("book path", () => {
  it("generates lowercase english directory slugs", () => {
    const slug = generateBookDirectorySlug()
    expect(slug).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/u)
  })
})

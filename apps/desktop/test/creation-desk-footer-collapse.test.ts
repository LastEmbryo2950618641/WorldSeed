import { describe, expect, it } from "vitest"

import {
  expandCreationDeskFooterCollapse,
  parseCreationDeskFooterCollapse,
  resolveCreationDeskFooterCollapseDrag,
} from "../src/renderer/src/features/editor/creation-desk-footer-collapse.js"

describe("parseCreationDeskFooterCollapse", () => {
  it("accepts known levels and defaults unknown values to full", () => {
    expect(parseCreationDeskFooterCollapse("composer")).toBe("composer")
    expect(parseCreationDeskFooterCollapse("minimal")).toBe("minimal")
    expect(parseCreationDeskFooterCollapse("nope")).toBe("full")
    expect(parseCreationDeskFooterCollapse(undefined)).toBe("full")
  })
})

describe("resolveCreationDeskFooterCollapseDrag", () => {
  it("collapses downward and expands upward by step thresholds", () => {
    expect(resolveCreationDeskFooterCollapseDrag("full", 47)).toBe("full")
    expect(resolveCreationDeskFooterCollapseDrag("full", 48)).toBe("composer")
    expect(resolveCreationDeskFooterCollapseDrag("full", 96)).toBe("minimal")
    expect(resolveCreationDeskFooterCollapseDrag("minimal", -48)).toBe("composer")
    expect(resolveCreationDeskFooterCollapseDrag("minimal", -200)).toBe("full")
  })
})

describe("expandCreationDeskFooterCollapse", () => {
  it("opens one level toward full", () => {
    expect(expandCreationDeskFooterCollapse("minimal")).toBe("composer")
    expect(expandCreationDeskFooterCollapse("composer")).toBe("full")
    expect(expandCreationDeskFooterCollapse("full")).toBe("full")
  })
})

import { describe, expect, it } from "vitest";
import { jobsAt } from "../src/schedule";

const at = (minute: number) => Date.UTC(2026, 9, 13, 12, minute, 0);

describe("one cron, three jobs", () => {
  it("keeps live discovery running every minute", () => {
    for (let minute = 0; minute < 60; minute += 1) expect(jobsAt(at(minute))).toContain("discovery");
  });

  it("refreshes pools at minutes 2 and 7 of every five, and expires intents at 0 and 5", () => {
    expect(jobsAt(at(2))).toEqual(["discovery", "refresh"]);
    expect(jobsAt(at(57))).toEqual(["discovery", "refresh"]);
    expect(jobsAt(at(0))).toEqual(["discovery", "expire"]);
    expect(jobsAt(at(35))).toEqual(["discovery", "expire"]);
    expect(jobsAt(at(1))).toEqual(["discovery"]);
    expect(jobsAt(at(3))).toEqual(["discovery"]);
  });

  it("never runs the two heavy jobs in the same minute", () => {
    for (let minute = 0; minute < 60; minute += 1) {
      const jobs = jobsAt(at(minute));
      expect(jobs.includes("refresh") && jobs.includes("expire")).toBe(false);
    }
  });
});

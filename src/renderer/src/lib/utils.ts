import { type CxOptions, cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";

/** Joins class names and lets later Tailwind classes override earlier ones. */
export function cn(...inputs: CxOptions): string {
  return twMerge(cx(inputs));
}

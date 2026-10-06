import clsx, { type ClassValue } from "clsx";

/** Class names joined (clsx). DS classes are CSS Modules, so nothing needs merging. */
export const cx = (...parts: ClassValue[]) => clsx(...parts);

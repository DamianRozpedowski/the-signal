import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

export const asyncH =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    throw new HttpError(400, `${first?.path?.join(".") || "input"}: ${first?.message ?? "invalid"}`);
  }
  return r.data;
}

export const intParam = (v: unknown, name = "id") => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}`);
  return n;
};

export const qstr = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
export const qint = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? Math.trunc(n) : undefined;
};

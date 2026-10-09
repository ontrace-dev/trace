import { customAlphabet } from "nanoid";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const gen = customAlphabet(alphabet, 16);
const token = customAlphabet(alphabet + "ABCDEFGHIJKLMNOPQRSTUVWXYZ", 32);

export const id = (prefix: string) => `${prefix}_${gen()}`;
export const secretToken = (len = 32) => token(len);

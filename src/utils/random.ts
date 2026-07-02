export const randomString = (length: number, chars: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"): string => {
  let result = "";
  const charsLength = chars.length;
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * charsLength));
  }
  return result;
};

export const randomRoomId = (): string => {
  return randomString(8, "ABCDEFGHJKMNPQRSTUVWXYZ23456789");
}
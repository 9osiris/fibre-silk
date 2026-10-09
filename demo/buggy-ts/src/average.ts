// average of a list of numbers
export function average(nums: number[]): number {
  if (nums.length === 0) throw new Error("empty list");
  let total = 0;
  for (const n of nums) total += n;
  return total / nums.length;
}

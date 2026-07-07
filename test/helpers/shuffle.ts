// Fisher-Yates style shuffle: returns -1, 0, or 1
export function shuffleCompareFn() {
  return Math.random() * 2 - 1
}
const hasSpaceAtEdges = (value: string) => /^\s|\s$/.test(value);
const isEmptyOrWhitespace = (value: string): boolean =>
  value.trim().length === 0;
const hasConsecutiveSpaces = (value: string): boolean => /\s{2,}/.test(value);

// Helper function to convert empty strings to null
const emptyStringToNull = (value: any) => {
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }

  return value;
};

// Helper function to convert string to boolean
const stringToBoolean = (value: any) => {
  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }

  return Boolean(value);
};

const isValidDateString = (value: string): boolean => {
  const date = new Date(value);
  return !isNaN(date.getTime());
};

export {
  emptyStringToNull,
  isValidDateString,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
  hasConsecutiveSpaces,
  stringToBoolean,
};

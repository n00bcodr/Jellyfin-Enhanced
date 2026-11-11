// strict -> strictFunctionTypes: parameters are checked contravariantly.
type Handler = (value: string | number) => void;
const onlyText = (value: string): void => { void value; };
export const handler: Handler = onlyText;

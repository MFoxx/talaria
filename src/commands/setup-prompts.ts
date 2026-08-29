import { confirm, input, select } from '@inquirer/prompts';
import type { Readable, Writable } from 'node:stream';

export interface SelectChoice<T extends string> {
  value: T;
  label: string;
  description: string;
}

/** Small prompt surface kept injectable so setup flows can be tested without a TTY. */
export interface SetupPrompter {
  select<T extends string>(question: string, choices: readonly SelectChoice<T>[]): Promise<T>;
  input(question: string, defaultValue?: string): Promise<string>;
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
  close(): void;
}

/** Inquirer-backed prompts used by the interactive CLI. */
export class InquirerSetupPrompter implements SetupPrompter {
  constructor(
    private readonly inputStream: Readable = process.stdin,
    private readonly output: Writable = process.stderr,
  ) {}

  async select<T extends string>(
    question: string,
    choices: readonly SelectChoice<T>[],
  ): Promise<T> {
    return select(
      {
        message: question,
        choices: choices.map((choice) => ({
          value: choice.value,
          name: choice.label,
          description: choice.description,
        })),
      },
      { input: this.inputStream, output: this.output },
    );
  }

  async input(question: string, defaultValue?: string): Promise<string> {
    return input(
      { message: question, ...(defaultValue === undefined ? {} : { default: defaultValue }) },
      { input: this.inputStream, output: this.output },
    );
  }

  async confirm(question: string, defaultValue = true): Promise<boolean> {
    return confirm(
      { message: question, default: defaultValue },
      { input: this.inputStream, output: this.output },
    );
  }

  close(): void {}
}

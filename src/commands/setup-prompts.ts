import { createInterface, type Interface } from 'node:readline/promises';
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

export class ReadlineSetupPrompter implements SetupPrompter {
  private readonly rl: Interface;

  constructor(
    input: Readable = process.stdin,
    private readonly output: Writable = process.stderr,
  ) {
    this.rl = createInterface({ input, output, terminal: true });
  }

  async select<T extends string>(
    question: string,
    choices: readonly SelectChoice<T>[],
  ): Promise<T> {
    this.output.write(`\n${question}\n`);
    choices.forEach((choice, index) => {
      this.output.write(`  ${index + 1}) ${choice.label}\n     ${choice.description}\n`);
    });

    for (;;) {
      const answer = (await this.rl.question(`Choose 1-${choices.length}: `)).trim();
      const index = Number.parseInt(answer, 10) - 1;
      const choice = choices[index];
      if (choice !== undefined && String(index + 1) === answer) return choice.value;
      this.output.write('Please enter one of the listed numbers.\n');
    }
  }

  async input(question: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue === undefined ? ': ' : ` [${defaultValue}]: `;
    const answer = (await this.rl.question(question + suffix)).trim();
    return answer || defaultValue || '';
  }

  async confirm(question: string, defaultValue = true): Promise<boolean> {
    const hint = defaultValue ? 'Y/n' : 'y/N';
    for (;;) {
      const answer = (await this.rl.question(`${question} [${hint}]: `)).trim().toLowerCase();
      if (!answer) return defaultValue;
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
      this.output.write('Please answer yes or no.\n');
    }
  }

  close(): void {
    this.rl.close();
  }
}

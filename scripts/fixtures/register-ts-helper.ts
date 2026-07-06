export class LoaderProbe {
  constructor(private readonly answer: number) {}

  get value(): number {
    return this.answer;
  }
}

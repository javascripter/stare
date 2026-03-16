export class AlreadyReportedError extends Error {
  readonly alreadyReported = true;

  constructor(
    message: string = "Command failed.",
    readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = "AlreadyReportedError";
  }
}

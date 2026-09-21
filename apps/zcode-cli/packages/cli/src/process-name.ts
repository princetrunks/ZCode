export const CLI_COMMAND_NAME = "sando";
export const CLI_PROCESS_NAME = "sando-cli";

interface ProcessTitleTarget {
  title: string;
}

export const setCliProcessTitle = (
  target: ProcessTitleTarget = process,
): void => {
  target.title = CLI_PROCESS_NAME;
};

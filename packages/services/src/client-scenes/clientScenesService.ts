import { PHONEHOME_NONE, type ApiClient } from "@zcode/shared";
import { readApiJson } from "../providers/api/apiJson.js";
import { ZCODE_CLIENT_SCENES_URL } from "../providers/api/apiEndpoints.js";
import type { ClientScenesResponse, IClientScenesService } from "./clientScenes.js";

export function createClientScenesService(dependencies: {
  apiClient: ApiClient;
}): IClientScenesService {
  return {
    // Sando phonehome=none：不请求 zcode.z.ai client/scenes，推荐场景只用本地内置。
    list: () =>
      PHONEHOME_NONE
        ? Promise.resolve({ code: 0, msg: "phonehome: none", data: [] })
        : readApiJson<ClientScenesResponse>(dependencies.apiClient, ZCODE_CLIENT_SCENES_URL, {
            method: "GET",
          }),
  };
}

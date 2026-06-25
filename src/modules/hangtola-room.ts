import { createRuleSet, RuleSet } from "@/core/rule-set";
import { createResRoom } from "./common/res-room";
import { ResourceService } from "@/services/resource-service";

export const createHangToLaRoom = (resourceService: ResourceService): RuleSet => {
    const resRoom = createResRoom(resourceService, {
        
    });

    return createRuleSet()
        .use(resRoom)
        .on("sys:userJoin", async (ctx, payload, next) => {
            // 发送当前的rankItems和rankTable
        })
        .on("room:addRankItem", async (ctx, payload, next) => {
            // 增加
        })
}
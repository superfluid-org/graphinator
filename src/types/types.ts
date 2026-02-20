import type {AddressLike} from "ethers";

export enum AgreementType {
    CFA = 0,
    GDA = 1
}

export type CriticalAccount = {
    id: AddressLike,
    totalNetFlowRate: number,
    totalCFANetFlowRate: number,
    token: Token,
    account: {
        id: AddressLike
    }
}

export type Flow = {
    agreementType: AgreementType,
    sender: AddressLike,
    receiver: AddressLike,
    token: AddressLike,
    flowrate: bigint,
    consumedDepositPercentage?: number,
};

export type Token = {
    decimals: number,
    isListed: boolean,
    isNativeAssetSuperToken: boolean,
    isSuperToken: boolean,
    name: string,
    symbol: string,
    id: AddressLike
}
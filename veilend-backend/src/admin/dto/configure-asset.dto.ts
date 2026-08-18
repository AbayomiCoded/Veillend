import { IsString, IsBoolean, IsOptional, IsNumber } from 'class-validator';

export class ConfigureAssetDto {
  @IsString()
  assetContractId: string;

  @IsBoolean()
  supported: boolean;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  symbol?: string;

  @IsOptional()
  @IsNumber()
  decimals?: number;
}

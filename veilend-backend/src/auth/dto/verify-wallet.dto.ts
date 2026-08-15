import { IsString } from 'class-validator';
import { IsStellarAddress } from '../../common/validators/is-stellar-address.validator';

export class VerifyWalletDto {
  @IsStellarAddress()
  walletAddress: string;

  @IsString()
  signature: string;

  @IsString()
  nonce: string;
}

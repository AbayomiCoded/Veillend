import { Controller, Get, Param } from '@nestjs/common';
import { PortfoliosService, PortfolioData } from './portfolios.service';
import { ServiceResponse } from '../stellar/types';
import { WalletAddressParamDto } from '../common/dto/wallet-address-param.dto';

@Controller('portfolios')
export class PortfoliosController {
  constructor(private readonly portfoliosService: PortfoliosService) {}

  @Get(':walletAddress')
  async getPortfolio(
    @Param() { walletAddress }: WalletAddressParamDto,
  ): Promise<ServiceResponse<PortfolioData>> {
    return this.portfoliosService.getPortfolio(walletAddress);
  }
}

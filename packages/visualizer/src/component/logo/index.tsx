import { useTheme } from '../../hooks/useTheme';
import './index.less';

export const LogoUrl =
  'https://gw.alicdn.com/imgextra/i2/O1CN01BXITpC1ID0dHakqfm_!!6000000000858-2-tps-498-501.png';

const LogoIconUrl =
  'https://gw.alicdn.com/imgextra/i2/O1CN01BXITpC1ID0dHakqfm_!!6000000000858-2-tps-498-501.png';

export const Logo = ({ hideLogo = false }: { hideLogo?: boolean }) => {
  if (hideLogo) {
    return null;
  }

  return (
    <div className="logo">
      <a
        href="https://fl-auto-test.fc.alibaba-inc.com/"
        target="_blank"
        rel="noreferrer"
      >
        <img alt="飞碟报告" src={LogoIconUrl} />
        <span className="logo-text">飞碟报告</span>
      </a>
    </div>
  );
};

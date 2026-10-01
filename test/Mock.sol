// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Minimal stand-ins for RUNUP V4 (quote token, launch token, bonding-curve Market).
// Used only to exercise the sniper + buy/sell end-to-end against a local anvil.
contract MockQuote {
    string public symbol = "USDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(allowance[f][msg.sender] >= a, "allow");
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

contract MockToken {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; totalSupply += a; }
    function burn(address from, uint256 a) external { balanceOf[from] -= a; totalSupply -= a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(allowance[f][msg.sender] >= a, "allow");
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

contract MockMarket {
    uint8 public phase;                 // 0 founding, 1 active, 2 graduated
    bool public active;
    uint256 public opening;
    uint256 public TICKET = 20_000_000; // 20 USDC
    uint256 public TICKET_TOKENS = 1e21;
    uint256 public ticketsSold;
    address public token;
    address public quoteToken;
    uint256 public realQuote;
    uint256 public realTokens;
    uint256 public graduationQuote = 81_000_000_000; // $81k
    address public creator;
    uint16 public FEE_BPS = 100;

    event CurveOpened(uint256 tickets, uint256 principal, uint256 graduationPrincipal);
    event Traded(address indexed trader, address indexed recipient, bool buy, uint256 quoteAmount, uint256 tokens, uint256 fee);

    constructor(address q, address t) { quoteToken = q; token = t; creator = msg.sender; }
    function setPhase(uint8 p) external { phase = p; active = (p == 1); if (p == 1) emit CurveOpened(ticketsSold, realQuote, graduationQuote); }
    function setOpening(uint256 o) external { opening = o; }

    // 18-decimal USD/token spot price (mirrors the real market's price()).
    function price() external view returns (uint256) {
        if (realTokens == 0) return 0;
        return realQuote * 1e30 / realTokens;
    }

    function quoteBuy(uint256 maximum) external view returns (uint256 spent, uint256 out, uint256 fee, bool graduates) {
        fee = maximum * FEE_BPS / 10000; spent = maximum; out = (maximum - fee) * 1e15; graduates = false;
    }
    function quoteSell(uint256 input) external view returns (uint256 out, uint256 fee) {
        out = input / 1e15; fee = out * FEE_BPS / 10000;
    }

    function buy(uint256 maximum, uint256 minimum, address recipient, uint256 deadline, bool expectedActive) external returns (uint256 spent, uint256 out) {
        require(!expectedActive || active, "not active");
        require(block.timestamp <= deadline, "deadline");
        uint256 fee = maximum * FEE_BPS / 10000; spent = maximum; out = (maximum - fee) * 1e15;
        require(out >= minimum, "slippage");
        (bool ok, ) = quoteToken.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), spent));
        require(ok, "transfer");
        (bool ok2, ) = token.call(abi.encodeWithSignature("mint(address,uint256)", recipient, out));
        require(ok2, "mint");
        realQuote += spent; realTokens += out;
        emit Traded(msg.sender, recipient, true, spent, out, fee);
    }

    function sell(uint256 input, uint256 minimum, address recipient, uint256 deadline, bool expectedActive) external returns (uint256 out) {
        require(!expectedActive || active, "not active");
        require(block.timestamp <= deadline, "deadline");
        uint256 fee = (input / 1e15) * FEE_BPS / 10000;
        out = input / 1e15 - fee;
        require(out >= minimum, "slippage");
        (bool ok, ) = token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), input));
        require(ok, "transfer");
        (bool ok2, ) = quoteToken.call(abi.encodeWithSignature("transfer(address,uint256)", recipient, out));
        require(ok2, "pay");
        realQuote -= out; realTokens -= input;
        emit Traded(msg.sender, recipient, false, out, input, fee);
    }
}
